/**
 * /admin/today — the structural half of its contract.
 *
 * The behavioural half lives in `src/lib/operatorToday.test.ts`, which runs the
 * real decision functions against real inputs, and the gate is proven end to
 * end in apps/api's `tests/unit/operator-today-gate.test.js`. This file covers
 * only what those two structurally cannot: that the page keeps routing its
 * decisions through the lib instead of re-deciding inline, that it reads the
 * platform-staff endpoint rather than assembling a cross-account view for
 * itself, and that it obeys the two design laws the app states about itself.
 *
 * COMMENT-BLIND, for the same reason design-system-contract.test.js is: the
 * page explains in prose which things it deliberately does not show, naming
 * some of them. A literal source scan would trip over the documentation of the
 * decision, which is the fastest way to get a guard deleted.
 *
 * Run: `node --test tests/admin-today-contract.test.js`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** Block comments first (covers JSX `{/* … *\/}`), then `//` not preceded by `:`. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const PAGE = 'src/pages/admin/today.tsx';
const LIB = 'src/lib/operatorToday.ts';
const pageSource = read(PAGE);
const page = stripComments(pageSource);
const lib = stripComments(read(LIB));

// ── One gate, and it is not this page's ──────────────────────────────────────

test('the page reads the platform-staff endpoint, not a cross-account query of its own', () => {
  // The gate is server-side (requireAuth + requirePlatformStaff on the metrics
  // router). The page's only job is to call the gated endpoint and render the
  // refusal when it comes back 403 — it must not, for instance, page through a
  // list of orgs and assemble the view client-side, which no gate would cover.
  assert.ok(/api\.getOperatorToday\(/.test(page), 'calls the dedicated client method');
  assert.ok(!/\/api\/v1\//.test(page), 'the page must not hand-build API paths');
});

test('the endpoint is reached through the api client, which names the gated route', () => {
  const api = stripComments(read('src/lib/api.ts'));
  assert.ok(
    /getOperatorToday[\s\S]{0,240}\/api\/v1\/metrics\/today/.test(api),
    'getOperatorToday must target /api/v1/metrics/today',
  );
});

test('a refusal is rendered, not swallowed', () => {
  // A non-staff signed-in user CAN navigate here — /admin pages are unlisted,
  // not route-guarded, exactly as /admin/retention is. The page must therefore
  // survive a 403 by saying so, rather than rendering an empty list, which
  // would read as "nobody got a brief today" — the worst possible wrong answer
  // for this page in particular.
  assert.ok(/InlineErrorState/.test(page), 'renders an error surface');
  assert.ok(/setError\(/.test(page), 'captures the failure');
  assert.ok(/catch\b/.test(page), 'the fetch has a rejection path');
});

// ── Decisions live in the lib ────────────────────────────────────────────────

test('the page does not re-derive what the lib already decides', () => {
  for (const fn of ['summarySentence', 'relativeTime', 'overflowLabel', 'displayName']) {
    assert.ok(new RegExp(`\\b${fn}\\(`).test(page), `${fn} must be used by the page`);
    assert.ok(new RegExp(`export function ${fn}`).test(lib), `${fn} must be defined in the lib`);
  }
});

test('no inline plural or time arithmetic survives in the page', () => {
  // These are the exact expressions that were lifted into the lib. Left inline
  // they are untestable, and they are where "1 people" comes from.
  assert.ok(!/\?\s*''\s*:\s*'s'/.test(page), 'inline pluralisation belongs in the lib');
  assert.ok(!/60000/.test(page), 'time arithmetic belongs in the lib');
  assert.ok(!/person\.email\s*\?\?/.test(page), 'the unknown-name fallback belongs in the lib');
});

// ── Design law 1: tokens only ────────────────────────────────────────────────

const TAILWIND_HUES = [
  'slate', 'gray', 'zinc', 'neutral', 'stone',
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
];
const RAW_PALETTE = new RegExp(
  String.raw`\b(?:bg|text|border|ring|outline|divide|from|via|to|fill|stroke|decoration|shadow|accent|caret)` +
    String.raw`-(?:${TAILWIND_HUES.join('|')})-(?:50|\d{3})\b`,
  'g',
);
const RAW_HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?\b/g;

test('the page is token-only — no raw palette classes, no raw hex', () => {
  // A raw Tailwind class is worse than a raw hex here: it LOOKS like a token,
  // so nobody notices it has no light-mode counterpart until the page is read
  // on the white surface.
  assert.deepEqual(page.match(RAW_PALETTE) ?? [], [], 'raw Tailwind palette class');
  assert.deepEqual(page.match(RAW_HEX) ?? [], [], 'raw hex colour');
});

test('no gradients anywhere on the page', () => {
  assert.ok(!/gradient/i.test(pageSource), 'gradients are a hard global rule');
  assert.ok(!/\bbg-gradient-|\bfrom-\[|\bvia-\[|\bto-\[/.test(page));
});

test('no emojis on the page', () => {
  // Hard global rule: two-tone line icons only. UsersIcon is the empty state.
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
  assert.ok(!EMOJI.test(pageSource), 'emoji found in the page source');
  assert.ok(/UsersIcon/.test(page), 'uses the existing line-icon set');
});

// ── Design law 2: tint means state ───────────────────────────────────────────

test('exactly one thing is tinted, and it is the one actionable state', () => {
  // Somebody's FIRST brief is the only thing on this page an operator would act
  // on. Counts, tools and project names are neutral by design — tinting them
  // would satisfy "use tokens" while making colour mean nothing, which is the
  // failure mode the TaskBoard lanes already demonstrated.
  const pills = page.match(/<DashboardStatusPill[^>]*>/g) ?? [];
  assert.equal(pills.length, 1, 'exactly one status pill on the page');
  assert.ok(/tone="success"/.test(pills[0]), 'the pill is the first-brief marker');
  assert.ok(
    /is_first_ever \?[\s\S]{0,160}DashboardStatusPill/.test(page),
    'the pill is conditional on is_first_ever',
  );
});

test('it is a list, not a tile dashboard', () => {
  // The brief for this page is "a list you can read in five seconds". Tiles and
  // charts are what you build once the number has a shape; at this volume the
  // useful artefact is the names.
  assert.ok(/<table/.test(page), 'renders a table of people');
  assert.ok(!/MetricTile/.test(page), 'no tile row — the counts are a sentence');
  assert.ok(!/\bChart\b|recharts|<canvas/i.test(page), 'no chart');
});

// ── What it deliberately does not claim ──────────────────────────────────────

test('the page reports no rate, percentage or score', () => {
  // Not derivable honestly at this volume, and the growth protocol is explicit
  // that a one-day rate move is not a result.
  assert.ok(!/toFixed\(/.test(page), 'no computed percentages');
  assert.ok(!/[^a-z]%[^a-z]|percent/i.test(page.replace(/w-full|max-w-|h-full/g, '')), 'no percentage rendered');
  assert.ok(!/(^|[^a-zA-Z])(score|conversion|churn)([^a-zA-Z]|$)/i.test(page), 'no invented metric');
});

test('every column shown maps to a stored fact', () => {
  // who / project / tool / when / first-ever — the five things
  // context_session_loads actually records. Nothing is estimated, and a missing
  // value renders as an em dash rather than a guess.
  for (const field of ['latest_project', 'latest_tool', 'last_brief_at', 'is_first_ever', 'briefs']) {
    assert.ok(new RegExp(`person\\.${field}\\b`).test(page), `${field} must be rendered`);
  }
  assert.ok(/—/.test(page), 'missing values render as an em dash');
});

test('duration is not shown, because it is not stored', () => {
  // context_session_loads has created_at and nothing else — there is no session
  // end, so "time spent" would have to be invented.
  assert.ok(!/duration|time_spent|session_length/i.test(page), 'duration is not derivable');
});
