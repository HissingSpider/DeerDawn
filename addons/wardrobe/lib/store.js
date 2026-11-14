'use strict';

// Thin helpers over ctx.records. Everything here goes through ctx; the add-on
// never touches storage, the filesystem or the network directly.

const PAGE = 200;
// A safety stop for listAll: a closet is hundreds of rows, not tens of
// thousands, and an unbounded loop over a misbehaving cursor must not spin.
const MAX_ROWS = 5000;

async function listAll(ctx, collection, where) {
  const rows = [];
  let cursor;
  for (;;) {
    const page = await ctx.records.list(collection, { where, limit: PAGE, cursor, order: 'created_at' });
    rows.push(...(page.rows || []));
    cursor = page.next_cursor;
    if (!cursor || rows.length >= MAX_ROWS) break;
  }
  return rows;
}

const REF_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomRef(prefix) {
  let out = prefix;
  for (let i = 0; i < 4; i += 1) out += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  return out;
}

// A short handle ("i3k9q") the agent can quote back cheaply. Unique per person
// and collection; checked against the store, not assumed.
async function newRef(ctx, collection, prefix) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const ref = randomRef(prefix);
    const taken = await ctx.records.count(collection, { ref });
    if (!taken) return ref;
  }
  // Twelve collisions in a 31^4 space means the space is crowded; widen it.
  return randomRef(prefix) + randomRef('');
}

// Resolve ids that may be record ids or short refs. Returns
// { found: Map(input -> row), missing: [input] }, preserving input order.
async function resolveMany(ctx, collection, inputs) {
  const found = new Map();
  const missing = [];
  const wanted = [...new Set((inputs || []).map((v) => String(v).trim()).filter(Boolean))];
  const byRef = [];
  for (const input of wanted) {
    let row = null;
    try {
      row = await ctx.records.get(collection, input);
    } catch {
      row = null;
    }
    if (row) found.set(input, row);
    else byRef.push(input);
  }
  if (byRef.length) {
    const page = await ctx.records.list(collection, { where: { ref: byRef }, limit: byRef.length + 10 });
    const index = new Map((page.rows || []).map((r) => [r.data && r.data.ref, r]));
    for (const input of byRef) {
      const row = index.get(input);
      if (row) found.set(input, row);
      else missing.push(input);
    }
  }
  return { found, missing, ordered: wanted.filter((w) => found.has(w)).map((w) => found.get(w)) };
}

async function resolveOne(ctx, collection, input) {
  if (!input) return null;
  const { ordered } = await resolveMany(ctx, collection, [input]);
  return ordered[0] || null;
}

module.exports = { listAll, newRef, resolveMany, resolveOne };
