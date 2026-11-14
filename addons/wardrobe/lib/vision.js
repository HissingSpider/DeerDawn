'use strict';

// Turning a vision model's reply into draft tags. The model is asked for strict
// JSON, but a reply is untrusted text: it may be fenced, chatty, truncated or
// simply wrong. parseVisionReply never throws; anything it cannot use is
// dropped, and a reply with nothing usable returns null so the item stays in
// the review queue.

const CATEGORIES = ['top', 'bottom', 'outerwear', 'shoes', 'accessory', 'one-piece'];
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

const VISION_PROMPT = [
  'You are cataloguing one item of clothing from a photo for a personal wardrobe.',
  'Reply with ONLY a JSON object, no prose, no code fence, with these keys:',
  '"name" (short, e.g. "Navy oxford shirt"),',
  `"category" (one of ${CATEGORIES.join(', ')}),`,
  '"subcategory" (e.g. shirt, jeans, sneakers),',
  '"colors" (array of plain colour names, main colour first, at most 4),',
  '"pattern" (solid, striped, checked, floral, graphic, other),',
  '"material" (best guess, or null),',
  '"formality" (integer 1 = gym or lounge to 5 = black tie),',
  '"warmth" (integer 1 = very light to 5 = heavy winter),',
  `"seasons" (array from ${SEASONS.join(', ')}),`,
  '"description" (one plain sentence describing the item).',
  'If the photo does not show clothing, reply {"error": "not clothing"}.',
].join(' ');

function cleanString(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.slice(0, max);
}

function cleanInt(value, min, max) {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanList(value, max, itemMax, allowed) {
  let list = value;
  if (typeof list === 'string') list = list.split(/[,/]/);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    const s = cleanString(v, itemMax);
    if (!s) continue;
    const lower = s.toLowerCase();
    const norm = lower === 'fall' ? 'autumn' : lower;
    if (allowed && !allowed.includes(norm)) continue;
    if (!out.includes(allowed ? norm : lower)) out.push(allowed ? norm : lower);
    if (out.length >= max) break;
  }
  return out;
}

function normaliseCategory(value) {
  const s = cleanString(value, 30);
  if (!s) return null;
  const lower = s.toLowerCase().replace(/[\s_]+/g, '-');
  if (CATEGORIES.includes(lower)) return lower;
  const aliases = {
    tops: 'top', shirt: 'top', bottoms: 'bottom', trousers: 'bottom', pants: 'bottom', jeans: 'bottom',
    skirt: 'bottom', shorts: 'bottom', coat: 'outerwear', jacket: 'outerwear', shoe: 'shoes',
    footwear: 'shoes', boots: 'shoes', sneakers: 'shoes', accessories: 'accessory', dress: 'one-piece',
    jumpsuit: 'one-piece', onepiece: 'one-piece', 'one-pieces': 'one-piece',
  };
  return aliases[lower] || null;
}

// Pull the first balanced JSON object out of a reply.
function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Returns { tags } with only the fields that survived cleaning, or
 * { error } when nothing usable came back. Never throws.
 */
function parseVisionReply(reply) {
  try {
    const obj = typeof reply === 'object' && reply !== null ? reply : extractJsonObject(reply);
    if (!obj) return { error: 'vision reply was not JSON' };
    if (obj.error) return { error: `vision model: ${cleanString(String(obj.error), 120) || 'refused'}` };
    const tags = {};
    const name = cleanString(obj.name, 120);
    if (name) tags.name = name;
    const category = normaliseCategory(obj.category);
    if (category) tags.category = category;
    const sub = cleanString(obj.subcategory, 60);
    if (sub) tags.subcategory = sub.toLowerCase();
    const colors = cleanList(obj.colors || obj.colours, 4, 30);
    if (colors.length) tags.colors = colors;
    const pattern = cleanString(obj.pattern, 40);
    if (pattern) tags.pattern = pattern.toLowerCase();
    const material = cleanString(obj.material, 60);
    if (material) tags.material = material.toLowerCase();
    const formality = cleanInt(obj.formality, 1, 5);
    if (formality !== null) tags.formality = formality;
    const warmth = cleanInt(obj.warmth, 1, 5);
    if (warmth !== null) tags.warmth = warmth;
    const seasons = cleanList(obj.seasons, 4, 10, SEASONS);
    if (seasons.length) tags.seasons = seasons;
    const description = cleanString(obj.description, 400);
    if (description) tags.description = description;
    // A reply with neither a name nor a category is not a catalogue entry.
    if (!tags.name && !tags.category) return { error: 'vision reply had no name or category' };
    return { tags };
  } catch {
    return { error: 'vision reply could not be read' };
  }
}

/**
 * Describe one attachment with ctx.llm and return the item patch to store.
 * Never throws: failures come back as { tag_error } so the item waits in the
 * review queue.
 */
async function tagFromPhoto(ctx, attachmentId) {
  if (!ctx.llm || typeof ctx.llm.describeImage !== 'function') return null;
  let buffer;
  try {
    buffer = await ctx.attachments.read(attachmentId, 'view');
  } catch (err) {
    ctx.log('wardrobe: could not read photo for tagging', { attachmentId, error: String(err && err.message) });
    return { tag_error: 'photo could not be read for tagging' };
  }
  let reply;
  try {
    reply = await ctx.llm.describeImage(buffer, VISION_PROMPT);
  } catch (err) {
    ctx.log('wardrobe: vision call failed', { attachmentId, error: String(err && err.message) });
    return { tag_error: 'vision model call failed' };
  }
  const parsed = parseVisionReply(reply);
  if (parsed.error) return { tag_error: parsed.error.slice(0, 200) };
  return { ...parsed.tags, tags_confirmed: false, tag_source: 'vision', tag_error: null };
}

module.exports = { parseVisionReply, tagFromPhoto, extractJsonObject, VISION_PROMPT, CATEGORIES, SEASONS };
