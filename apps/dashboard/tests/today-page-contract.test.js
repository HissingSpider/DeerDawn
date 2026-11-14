/**
 * Today (`src/pages/index.tsx`) — the structural half of its contract.
 *
 * The behavioural half lives in `src/lib/todayConnection.test.ts`, which runs
 * the real decision functions against real inputs. This file covers only what
 * that one structurally cannot: that the page still ROUTES its decisions through
 * those functions instead of re-deciding inline, which is how the duplicate CTA
 * got there in the first place — two components each answering "should I show a
 * connect button?" for themselves, neither aware of the other.
 *
 * Kept deliberately narrow. A source-text assertion cannot see a render tree, so
 * anything it claims about behaviour is a proxy at best; every assertion here is
 * about wiring, and the ones about outcomes are next door.
 *
 * Run: `node --test tests/today-page-contract.test.js`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const PAGE = 'src/pages/index.tsx';
const LIB = 'src/lib/todayConnection.ts';
const page = read(PAGE);
const lib = read(LIB);

/** Source with block and line comments stripped — comments are not behaviour. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageCode = code(page);

const countOf = (source, pattern) => (source.match(pattern) || []).length;

// ── One CTA, one route ───────────────────────────────────────────────────────

test('Today never links a connect CTA at /setup', () => {
  // The bug: the empty hero sent the reader to /onboarding and the connection
  // strip, same words, sent them to /setup — two buttons, two routes, stacked on
  // the first screen a non-activated account ever sees. /setup is the tools
  // MANAGEMENT table; it is the right destination for a SECOND tool (see
  // SecondToolNudge) and the wrong one for a first.
  assert.equal(
    countOf(pageCode, /['"]\/setup['"]/g),
    0,
    'Today links to /setup again — the connect CTA has one destination, CONNECT_ROUTE',
  );
});

test('every connect CTA on Today comes from the shared constants', () => {
  assert.match(
    pageCode,
    /import\s*\{[^}]*\bCONNECT_ROUTE\b[^}]*\}\s*from\s*['"]@\/lib\/todayConnection['"]/s,
    'Today must import CONNECT_ROUTE rather than hard-coding a destination',
  );
  assert.equal(
    countOf(pageCode, /href=["']\/onboarding["']/g),
    0,
    'a hard-coded /onboarding href bypasses CONNECT_ROUTE — the next route change would ' +
      'move one CTA and leave the other behind, which is how the two diverged before',
  );

  // Every rendered CTA label is paired with the shared route: same count, so a
  // third button cannot appear pointing somewhere else.
  const labels = countOf(pageCode, /\{CONNECT_CTA_LABEL\}/g);
  const routes = countOf(pageCode, /href=\{CONNECT_ROUTE\}/g);
  assert.ok(labels > 0, 'Today still needs a route out for an unconnected account');
  assert.equal(
    labels,
    routes,
    `${labels} connect labels but ${routes} CONNECT_ROUTE hrefs — a CTA is pointing elsewhere`,
  );
});

test('the empty-surface sentence is chosen by the shared reader, not written into the page', () => {
  // `mcp_surfaces` is a 30-day window server-side, so an empty list means EITHER
  // "never connected" or "connected, then quiet for a month". The page rendered
  // one sentence for both — "nothing is reading them" — to accounts with
  // hundreds of briefed sessions, in the hoisted slot. Which sentence, and which
  // destination, is now absentCallout's decision; it is exercised against real
  // inputs in src/lib/todayConnection.test.ts.
  assert.match(
    pageCode,
    /absentCallout\(/,
    'Today must ask absentCallout what an empty surface list means',
  );
  assert.equal(
    countOf(pageCode, /No surface has called in/g),
    0,
    'the never-connected sentence is inlined in the page again — it is one of two branches ' +
      'and a page that writes it down cannot render the other',
  );
  assert.match(
    pageCode,
    /readConnectionState\(\s*bootstrap\?\.sync_health\?\.mcp_surfaces\s*,\s*now \?\? 0\s*,\s*bootstrap\?\.sync_health\s*,?\s*\)/,
    'the reader must be handed the durable half of sync_health (has_first_sync / session_stats) — ' +
      'without it every quiet account reads as a brand-new one again',
  );
});

test('the connection strip does not decide its own visibility', () => {
  // The zero-state suppression has to be the shared decision, not a second
  // opinion formed inside the component. `connectionPlacement` is tested against
  // real inputs in src/lib/todayConnection.test.ts.
  assert.match(pageCode, /connectionPlacement\(/, 'Today must ask connectionPlacement where the strip goes');
  assert.match(pageCode, /readConnectionState\(/, 'Today must read the surface state through the shared reader');
});

// ── Actionable first ─────────────────────────────────────────────────────────

test('the strip has both a hoisted and a footer position, chosen by placement', () => {
  assert.match(
    pageCode,
    /placement === 'top'/,
    'the hoisted slot is gone — a stale or missing surface would render as a footer again',
  );
  assert.match(pageCode, /placement === 'footer'/, 'the footer slot is gone');

  // Position, not duplication: the hoisted slot must sit ABOVE the resume card
  // and the footer slot BELOW it, or "hoisted" means nothing.
  const top = pageCode.indexOf("placement === 'top'");
  const resume = pageCode.indexOf('<ResumeCard');
  const footer = pageCode.indexOf("placement === 'footer'");
  assert.ok(top > -1 && resume > -1 && footer > -1);
  assert.ok(top < resume, 'the actionable strip must render above the resume card');
  assert.ok(footer > resume, 'the quiet strip must render below the resume card');
});

// ── The proof line ───────────────────────────────────────────────────────────

test('the proof line is derived from the bootstrap, never written down', () => {
  assert.match(
    pageCode,
    /proofLine\(\s*bootstrap\?\.sync_health\?\.session_stats\s*\)/,
    'the proof line must read sync_health.session_stats from the bootstrap the page already ' +
      'fetches — a second request, or a number from anywhere else, is not the same claim',
  );
  // No sample numbers hard-coded into the page: a plausible-looking constant is
  // exactly the failure this line exists to avoid.
  assert.equal(
    countOf(pageCode, /\d[\d,]*\s+sessions?\s+briefed/gi),
    0,
    'a session count is written into the page source — it must come from the API or not render',
  );
});

test('proofLine refuses to guess', () => {
  assert.match(
    code(lib),
    /return null/,
    'proofLine must have a "render nothing" path — a memory product showing an invented ' +
      'metric is worse than one showing none',
  );
});

test('the proof line does not reintroduce a hydration mismatch', () => {
  // The page renders on the server and again in the browser. Locale/time-zone
  // formatters disagree across that boundary, on the first thing a returning
  // user sees. Same reason useNow() exists in this page.
  for (const [name, source] of [[PAGE, pageCode], [LIB, code(lib)]]) {
    assert.equal(
      countOf(source, /toLocale(?:Date|Time)?String\(/g),
      0,
      `${name} formats a date with a locale-dependent formatter — server and client will disagree`,
    );
  }
});

// ── Guards on behaviour that already shipped ─────────────────────────────────

test('a failed projects fetch is still distinct from an empty board', () => {
  // Setting projects to [] on failure rendered the empty hero, so a returning
  // user with five projects and an expired token was told, in the largest type
  // on screen, that there was nothing to pick up. Failure is not emptiness.
  assert.match(pageCode, /setFailed\(true\)/, 'the failure branch is gone');
  assert.equal(
    countOf(pageCode, /setProjects\(\[\]\)/g),
    0,
    'the catch sets projects to an empty array again — that renders the zero state on a failure',
  );
  assert.match(
    pageCode,
    /projects === null \? null/,
    'the loading / failed / empty three-state split has been collapsed back to two',
  );
});

test('Today adds no gradient, no emoji and no raw colour', () => {
  for (const [name, source] of [[PAGE, page], [LIB, lib]]) {
    assert.equal(countOf(source, /gradient/gi), 0, `${name} uses a gradient`);
    assert.equal(
      countOf(source, /#[0-9a-fA-F]{3,8}\b/g),
      0,
      `${name} hard-codes a hex colour — colours come from the token layer in globals.css`,
    );
    assert.equal(
      countOf(source, /\b(?:bg|text|border|ring)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g),
      0,
      `${name} uses a raw Tailwind palette class — that rule is broken elsewhere and must not spread`,
    );
    assert.equal(
      countOf(source, /\p{Extended_Pictographic}/gu),
      0,
      `${name} contains an emoji`,
    );
  }
});

/**
 * BriefFreshness had the same windowed-array bug as Today (2026-08-29).
 *
 * `sync_health.mcp_surfaces` is a 30-day window server-side. Reading an empty
 * array as "never" told an established user quiet for a month that their brief
 * had never synced — the one thing a memory product must not say wrongly. The
 * lifetime signals are in the same payload, and `everConnected()` is the rule
 * Today already uses.
 */
test('BriefFreshness distinguishes never-connected from quiet, using the shared rule', () => {
  const src = fs.readFileSync(
    path.join(root, 'src/components/dashboard/brief/BriefFreshness.tsx'),
    'utf8'
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.ok(
    code.includes('everConnected'),
    'BriefFreshness must use everConnected() rather than a second copy of the rule'
  );
  assert.ok(
    code.includes('SURFACE_WINDOW_DAYS'),
    'the window length must come from the shared constant, not be written into the copy'
  );
  // "not synced yet" must no longer be the only alternative to a timestamp.
  assert.ok(
    /hasConnectedEver|everConnected\(/.test(code) && code.includes("'not synced yet'"),
    'the never-connected copy should survive, but only behind the lifetime check'
  );
});

/**
 * SecondToolNudge made a LIFETIME claim off the same windowed array.
 *
 * `identifiedSurfaces(mcp_surfaces)` returning one row means one tool called in
 * during the 30-day window — not one tool ever. Its copy read "Everything so
 * far has reached you through <tool>", which is false for anyone who used a
 * different editor two months ago and switched.
 *
 * This one cannot be fixed the way BriefFreshness was: `has_first_sync` and
 * `session_stats.total_sessions` are account-wide, so nothing in the payload
 * counts SURFACES over a lifetime. The remaining honest move is the one
 * `absentCallout()` makes — claim only the window, and name it — so the pin is
 * that the number comes from the shared constant and the lifetime phrasing does
 * not come back.
 */
test('SecondToolNudge claims only the window its data covers', () => {
  const nudge = code(read('src/components/dashboard/brief/SecondToolNudge.tsx'));

  assert.ok(
    nudge.includes('SURFACE_WINDOW_DAYS'),
    'the window length must come from the shared constant, not be typed into the copy',
  );
  assert.ok(
    !/\bso far\b/i.test(nudge),
    '"so far" is a lifetime claim read off the 30-day mcp_surfaces window — the BriefFreshness bug',
  );
});

/**
 * The Google Ads purchase value was reporting a retired price (2026-08-29).
 *
 * `purchaseValue` in UpgradeSuccessModal hard-coded 96 and 10. Pro moved to $12
 * on 2026-08-27 and every display surface followed, so the bidding signal was
 * quietly reporting a number the product no longer charges — and Google bids on
 * that value. CI already pins planCopy to plans.js, so the value belongs there.
 */
test('the purchase conversion value is derived, not a typed price', () => {
  const src = fs.readFileSync(
    path.join(root, 'src/components/dashboard/UpgradeSuccessModal.tsx'),
    'utf8'
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fn = code.slice(code.indexOf('function purchaseValue'), code.indexOf('export function UpgradeSuccessModal'));

  assert.ok(fn.includes('PRICE_ANNUAL') && fn.includes('PRICE_MONTHLY'), 'must use the pinned constants');
  for (const stale of ['96', '10']) {
    assert.ok(
      !new RegExp(`return billing === 'annual' \\? ${stale}`).test(fn),
      `purchaseValue still returns the literal ${stale}`
    );
  }
});
