/**
 * JOURNEY ROUND 2 (R2-4) — PHASE 5 FINDS THE SAME DUPLICATES WITHOUT COMPARING
 * EVERY PAIR.
 *
 * Phase 5 of the nightly vault job used to find each decision node's survivor
 * with kept.find over every node it had kept before it: 20,000 decisions in one
 * project was 200 million comparisons with no await among them, and the API
 * answered nothing for the 13 minutes they took. It now files the nodes it
 * keeps under the keys a match needs and looks the survivor up.
 *
 * That is only a fix if it deletes exactly what the pairwise loop deleted. The
 * pairwise loop is kept below, verbatim but for the database, as the reference;
 * both run over the same random vault — true duplicates by case, spacing and a
 * trailing stop, texts cut by the extractor (80 + "...", 240 + "...") and by the
 * store (279 + "…"), long shared openings, scoped / clip / hand-written / wrong-
 * type keys, question-titled answers, authors, statuses, pins, curation and
 * private copies — and must name the same [survivor, removed] pairs in the same
 * order.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { decisionNodeText, decisionNodeFullKey } = require('../../src/services/contextSyncService');
const { normalizeKey, clip } = require('../../src/services/contextGraphService');
const { duplicateDecisionPairs } = require('../../src/jobs/vaultRemediationJob');

// ── The reference: phase 5's matching before journey r2 ─────────────────────

function normalizeDecisionTitle(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!;:,\s]+$/, '');
}

function sameDecision(a, b) {
  const da = decisionNodeText(a);
  const db_ = decisionNodeText(b);
  if (!da.text || !db_.text) return false;
  if (!da.clipped && !db_.clipped) {
    const ta = normalizeDecisionTitle(da.text);
    return Boolean(ta) && ta === normalizeDecisionTitle(db_.text);
  }
  const ka = decisionNodeFullKey(a, da.visible);
  const kb = decisionNodeFullKey(b, db_.visible);
  return Boolean(ka && kb) && ka === kb;
}

function titleAddsNothing(loser, survivor) {
  const title = normalizeDecisionTitle(loser.title);
  if (!title || title === normalizeDecisionTitle(survivor.title)) return true;
  return normalizeDecisionTitle(decisionNodeText(loser).visible).startsWith(title);
}

const nodeAuthor = (node) => node.metadata?.contributed_by || null;
const isResolvedNode = (node) => String(node.metadata?.status || '').toLowerCase() === 'resolved';
const isHandKept = (node) => ['true', '1'].includes(String(node.metadata?.pinned ?? '').toLowerCase())
  || String(node.metadata?.curation_state || '').toLowerCase() === 'curated';

function referencePairs(rows, stats) {
  const groups = new Map();
  for (const node of rows) {
    if (isHandKept(node)) continue;
    const key = `${node.owner_key}::${node.project_id || ''}::${node.metadata?.private_to || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const pairs = [];
  for (const nodes of groups.values()) {
    const kept = [];
    for (const node of nodes) {
      const survivor = kept.find((k) => (
        nodeAuthor(k) === nodeAuthor(node)
        && isResolvedNode(k) === isResolvedNode(node)
        && sameDecision(k, node)
        && titleAddsNothing(node, k)
      ));
      // What the vault exercised, so a seed that finds nothing interesting fails.
      const sameText = kept.find((k) => nodeAuthor(k) === nodeAuthor(node) && isResolvedNode(k) === isResolvedNode(node) && sameDecision(k, node));
      if (sameText && !survivor) stats.keptForTitle += 1;
      if (sameText && survivor && sameText !== survivor) stats.laterSurvivorForTitle += 1;
      if (!survivor) { kept.push(node); continue; }
      if (decisionNodeText(node).clipped || decisionNodeText(survivor).clipped) stats.clippedPairs += 1;
      if (decisionNodeText(node).clipped !== decisionNodeText(survivor).clipped) stats.mixedPairs += 1;
      pairs.push([survivor.node_id, node.node_id]);
    }
  }
  return pairs;
}

// ── A random vault ──────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAD = 'the measured p99 under the cohort load test stayed flat across three runs and the cost fell ';
function basePool() {
  const pool = [
    'Use Postgres 16 for the ledger',
    'use postgres 16 for the ledger storage layer',
    'Use Postgres 16 for the audit log storage layer',
    'Deploy the API on Fly.io in the iad region',
    'Deploy the worker on Fly.io in the iad region',
    'Frankfurt (eu-central-1), on dedicated hosts.',
    'Frankfurt',
    'Adopt Redis as the cache layer',
    'Adopt Redis as the cache layer...',
    '...',
    'ok',
  ];
  // Openings shared past each cut: the extractor's title (80), its summary
  // (240) and the store's (280), each with different endings.
  for (const [length, count] of [[60, 6], [100, 8], [250, 8], [300, 8], [700, 6]]) {
    const opening = `Shard the ledger by tenant, ${PAD.repeat(10)}`.slice(0, length);
    for (let k = 0; k < count; k += 1) pool.push(`${opening} variant ${k} ends here`);
  }
  for (let k = 0; k < 90; k += 1) {
    const length = [20, 70, 79, 81, 150, 239, 241, 279, 281, 400][k % 10];
    pool.push(`Decision ${k}: ${PAD.repeat(8)}`.slice(0, length));
  }
  return pool;
}

function variant(rand, text) {
  const r = rand();
  if (r < 0.3) return text;
  if (r < 0.4) return text.toUpperCase();
  if (r < 0.5) return text.toLowerCase();
  if (r < 0.6) return text.replace(/ /g, '  ');
  if (r < 0.7) return `  ${text} `;
  if (r < 0.85) return `${text.replace(/[.!;:,\s]+$/, '')}${['.', '!', ';', ':', ',', '...', ' .', ''][Math.floor(rand() * 8)]}`;
  if (r < 0.95) return `${text} for the EU tenants`;
  return text.slice(0, Math.max(1, Math.floor(text.length / 2)));
}

function pick(rand, weighted) {
  const total = weighted.reduce((sum, [w]) => sum + w, 0);
  let r = rand() * total;
  for (const [w, value] of weighted) {
    r -= w;
    if (r < 0) return typeof value === 'function' ? value() : value;
  }
  const last = weighted[weighted.length - 1][1];
  return typeof last === 'function' ? last() : last;
}

function randomVault(seed, count) {
  const rand = mulberry32(seed);
  const pool = basePool();
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const base = pool[Math.floor(rand() * pool.length)];
    const text = variant(rand, base);
    const other = pool[Math.floor(rand() * pool.length)];
    const summary = pick(rand, [
      [5, () => (text.trim().length > 280 ? `${text.trim().slice(0, 279)}…` : text)],
      [3, () => clip(text, 240)],
      [1, ''],
      [1, () => other],
    ]);
    const title = pick(rand, [
      [5, () => clip(text, 80)],
      [2, text],
      [1, ''],
      [3, () => `Which region hosts tenant cohort ${Math.floor(rand() * 2)}?`],
      [1, () => clip(other, 80)],
      [1, () => text.split(' ').slice(0, 3).join(' ')],
    ]);
    const slug = normalizeKey(text);
    const canonicalKey = pick(rand, [
      [6, `decision:${slug}`],
      [2, () => `decision:${normalizeKey(clip(text, 80))}`],
      [1, () => `decision:${slug}::in.proj-${Math.floor(rand() * 3)}`],
      [1, () => `decision:${slug}${['.', '-', '..'][Math.floor(rand() * 3)]}`],
      [1, () => `decision:hand-${Math.floor(rand() * 20)}`],
      [1, () => `knowledge:${slug}`],
    ]);
    const metadata = {};
    const author = pick(rand, [[4, undefined], [1, null], [1, ''], [4, 'user-a'], [3, 'user-b']]);
    if (author !== undefined) metadata.contributed_by = author;
    const status = pick(rand, [[6, undefined], [3, 'resolved'], [1, 'Resolved'], [1, 'active'], [1, 'archived']]);
    if (status !== undefined) metadata.status = status;
    const pinned = pick(rand, [[30, undefined], [1, true], [1, 'true'], [1, '1'], [1, 'false'], [1, 1]]);
    if (pinned !== undefined) metadata.pinned = pinned;
    metadata.curation_state = pick(rand, [[30, 'promoted'], [1, 'curated'], [1, 'CURATED'], [3, undefined]]);
    const privateTo = pick(rand, [[12, undefined], [1, 'user-x'], [1, 'user-y']]);
    if (privateTo !== undefined) metadata.private_to = privateTo;
    rows.push({
      node_id: `n${String(i).padStart(5, '0')}`,
      owner_key: pick(rand, [[3, 'owner-1'], [1, 'owner-2']]),
      project_id: pick(rand, [[4, 'proj-1'], [2, 'proj-2'], [1, null]]),
      canonical_key: canonicalKey,
      title,
      summary,
      metadata,
    });
  }
  // The job reads them ORDER BY created_at, node_id: creation order here.
  return rows;
}

const pairsOf = (rows) => [...duplicateDecisionPairs(rows)].filter(Boolean).map(([survivor, node]) => [survivor.node_id, node.node_id]);

test('R2-4: phase 5 names exactly the pairwise loop\'s [survivor, removed] pairs, in its order, over random vaults', (t) => {
  const totals = { pairs: 0, keptForTitle: 0, laterSurvivorForTitle: 0, clippedPairs: 0, mixedPairs: 0 };
  for (const seed of [1, 7, 42, 2026, 90210]) {
    const rows = randomVault(seed, 4000);
    const stats = { keptForTitle: 0, laterSurvivorForTitle: 0, clippedPairs: 0, mixedPairs: 0 };
    const expected = referencePairs(rows, stats);
    const actual = pairsOf(rows);
    assert.deepEqual(actual, expected, `seed ${seed}: the same pairs, in the same order`);
    totals.pairs += expected.length;
    for (const key of Object.keys(stats)) totals[key] += stats[key];
  }
  // The seeds reach every way a match is decided, or the agreement proves little.
  t.diagnostic(JSON.stringify(totals));
  assert.ok(totals.pairs > 1000, JSON.stringify(totals));
  assert.ok(totals.clippedPairs > 50, JSON.stringify(totals));
  assert.ok(totals.mixedPairs > 10, JSON.stringify(totals));
  assert.ok(totals.keptForTitle > 50, JSON.stringify(totals));
  assert.ok(totals.laterSurvivorForTitle > 10, JSON.stringify(totals));
});

test('R2-4: phase 5 keeps the pairwise loop\'s rules at the edges', () => {
  const node = (id, fields) => ({ node_id: id, owner_key: 'o', project_id: 'p', canonical_key: `decision:${id}`, title: '', summary: '', metadata: {}, ...fields });
  const long = `Shard the ledger by tenant, ${PAD.repeat(4)}`;
  const other = `Replicate the ledger to Frankfurt, ${PAD.repeat(4)}`;
  const rows = [
    // Different authors, and an attributed and an unattributed copy: kept apart.
    node('a1', { summary: 'Use Postgres 16', metadata: { contributed_by: 'user-a' } }),
    node('a2', { summary: 'use postgres 16.', metadata: { contributed_by: 'user-b' } }),
    node('a3', { summary: 'USE POSTGRES 16', metadata: {} }),
    node('a4', { summary: 'use  postgres 16!', metadata: { contributed_by: 'user-a' } }),
    // Resolved and active with one text: a re-opened decision, both kept.
    node('r1', { summary: 'Adopt Redis', metadata: { status: 'resolved' } }),
    node('r2', { summary: 'adopt redis', metadata: {} }),
    node('r3', { summary: 'Adopt Redis.', metadata: { status: 'RESOLVED' } }),
    // Two questions answered alike: the answer's text, the question's title.
    node('q1', { title: 'Which region hosts the EU tenants?', summary: 'Frankfurt' }),
    node('q2', { title: 'Which region hosts the DR replica?', summary: 'Frankfurt' }),
    node('q3', { title: 'Which region hosts the DR replica?', summary: 'frankfurt.' }),
    // A cut summary against the whole text, decided by the keys.
    node('c1', { summary: long, canonical_key: `decision:${normalizeKey(long)}` }),
    node('c2', { summary: clip(long, 240), title: clip(long, 80), canonical_key: `decision:${normalizeKey(long)}.` }),
    // Pinned and curated nodes never merge.
    node('h1', { summary: 'Pin the CDN', metadata: { pinned: true } }),
    node('h2', { summary: 'pin the cdn' }),
    node('h3', { summary: 'Pin the CDN.', metadata: { curation_state: 'curated' } }),
    // No text at all is nobody's duplicate.
    node('e1', {}),
    node('e2', {}),
    // Two whole texts that differ only where the key folds them (both kept),
    // then a cut copy with the same title: it goes to the EARLIER of the two.
    node('k1', { summary: other, title: 'Which region hosts the ledger replica?', canonical_key: `decision:${normalizeKey(other)}` }),
    node('k2', { summary: other.replace('ledger to', 'ledger, to'), title: 'Which region hosts the ledger replica?', canonical_key: `decision:${normalizeKey(other)}.` }),
    node('k3', { summary: clip(other, 240), title: 'Which region hosts the ledger replica?', canonical_key: `decision:${normalizeKey(other)}-` }),
  ];
  const stats = { keptForTitle: 0, laterSurvivorForTitle: 0, clippedPairs: 0, mixedPairs: 0 };
  const expected = referencePairs(rows, stats);
  assert.deepEqual(pairsOf(rows), expected);
  assert.deepEqual(expected, [['a1', 'a4'], ['r1', 'r3'], ['q2', 'q3'], ['c1', 'c2'], ['k1', 'k3']]);
});
