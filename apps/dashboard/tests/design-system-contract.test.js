/**
 * Design-system contracts: the two laws the dashboard states about itself, made
 * enforceable.
 *
 * LAW 1 — one colour system. globals.css says it at the top of the token block:
 * "Add new colors as tokens here, never as raw hex in components." A raw Tailwind
 * palette class (`text-sky-400`, `bg-slate-400`, `bg-amber-500/[0.05]`) breaks it
 * the same way a raw hex does, and worse in one respect: it LOOKS like a design
 * token, so nobody notices it has no light-mode counterpart. That is exactly how
 * `TaskBoard`'s six lanes and `BriefSlot`'s Decided/Open accents came to be
 * invisible or wrong on the white surface.
 *
 * LAW 2 — tint means state. Stated on `DashboardStatusPill` in PageScaffold.tsx:
 * a surface is tinted only when it encodes STATE the user may need to act on. The
 * two laws pull in different directions if you only remember the first: tokenising
 * six decorative lane hues would have satisfied Law 1 and still left a board where
 * colour meant nothing. So this file pins the OUTCOME — which surfaces carry
 * colour — not just the mechanism.
 *
 * LAW 3 — one page-header system. Three coexisted: a 38-56px display
 * `.dashboard-title` on every PageScaffold route, an 18px inline h1 on /memory,
 * /settings/usage and /setup, and no h1 at all on /, /projects, /board and
 * /portfolio. Every route now names itself with `.dashboard-title`.
 *
 * COMMENT-BLIND. Every assertion below runs against source with comments
 * stripped. The files being guarded explain, in prose, which palette values they
 * removed and why — naming `text-sky-400` and `#4ade80` on purpose. A literal
 * source-text scan would fail on the documentation of the fix, which is the
 * fastest way to get a guard deleted.
 *
 * Run: `node --test tests/design-system-contract.test.js`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/**
 * Strip comments so assertions see CODE only.
 *
 * Block comments first (this also covers JSX `{ /* ... *\/ }`), then `//` to end
 * of line — but never when preceded by `:`, so `https://…` in a string survives
 * as code rather than swallowing the rest of the line.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const TAILWIND_HUES = [
  'slate', 'gray', 'zinc', 'neutral', 'stone',
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
];

/** `text-sky-400`, `bg-amber-500/[0.05]`, `ring-violet-400/50`, `border-red-500/20`. */
const RAW_PALETTE = new RegExp(
  String.raw`\b(?:bg|text|border|ring|outline|divide|from|via|to|fill|stroke|decoration|shadow|accent|caret)` +
    String.raw`-(?:${TAILWIND_HUES.join('|')})-(?:50|\d{3})\b`,
  'g',
);

/** `#abc`, `#aabbcc`, `#aabbccdd` — including inside a Tailwind arbitrary value. */
const RAW_HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?\b/g;

/**
 * The files this contract owns. Each was carrying raw palette values with no
 * light-mode counterpart; each is now token-only. The list is deliberately narrow
 * — it pins what was fixed, rather than declaring the whole app clean.
 *
 * `PageScaffold.tsx` is here because it is where the tint law is written down.
 */
const TOKEN_ONLY_FILES = [
  'src/components/dashboard/brief/TaskBoard.tsx',
  'src/components/dashboard/brief/BriefSlot.tsx',
  'src/components/dashboard/brief/BriefLine.tsx',
  'src/components/dashboard/PageScaffold.tsx',
  'src/pages/portfolio.tsx',
  // The crash fallback. It was the worst offender in the app — #EF4444 for the
  // heading, #0F3D2E/#145A42 for the primary button, #4B5563 for a hover border
  // — i.e. the one surface a user only ever sees on a bad day was also the one
  // most likely to render dark-palette colours on the white theme.
  'src/components/ErrorBoundary.tsx',
];

for (const file of TOKEN_ONLY_FILES) {
  test(`${file} uses colour tokens only — no raw Tailwind palette class`, () => {
    const found = stripComments(read(file)).match(RAW_PALETTE) || [];
    assert.deepEqual(
      [...new Set(found)],
      [],
      `${file} is back on the raw Tailwind palette. These classes have no light-mode ` +
        `counterpart, so they render wrong on the white surface. Use a token from ` +
        `globals.css (text-status-danger, text-status-warning, text-text-muted, ` +
        `text-primary, bg-overlay-*) or add a token PAIR there first.`,
    );
  });

  test(`${file} uses colour tokens only — no raw hex`, () => {
    const found = stripComments(read(file)).match(RAW_HEX) || [];
    assert.deepEqual(
      [...new Set(found)],
      [],
      `${file} hard-codes a hex colour. globals.css: "Add new colors as tokens ` +
        `here, never as raw hex in components." A hex written in a component ` +
        `exists in one theme only.`,
    );
  });
}

test('the tint law holds on the task board: BLOCKED, and nothing else', () => {
  // Six lanes in six hues encoded no state — the label beside the dot already
  // named the lane. The regression this guards is not "raw palette came back"
  // (the scan above covers that) but "every lane got a token of its own", which
  // would pass that scan and still mean nothing.
  const board = stripComments(read('src/components/dashboard/brief/TaskBoard.tsx'));

  const tones = board.match(/const PHASE_TONE[\s\S]*?\n};/);
  assert.ok(tones, 'TaskBoard no longer declares a PHASE_TONE map');
  const table = tones[0];

  for (const phase of ['backlog', 'in_progress', 'integration', 'testing', 'done']) {
    assert.match(
      table,
      new RegExp(`${phase}:\\s*NEUTRAL_LANE`),
      `the ${phase} lane is tinted again. Only BLOCKED is a request to the user; ` +
        `every other lane's identity is already carried by its label and position, ` +
        `and tinting all of them is what stopped colour meaning anything here.`,
    );
  }
  assert.match(
    table,
    /blocked:\s*\{[^}]*status-danger/,
    'BLOCKED lost its danger tint — it is the one lane that asks the user to act',
  );

  // The drop target is a live interaction, not a lane identity: one ring, brand
  // coloured, shared by every column.
  assert.match(board, /const DROP_RING = 'ring-primary\/\d+';/, 'the drop-target ring is no longer a single brand ring');
});

test('the tint law holds on the brief slots: LANDMINE, and nothing else', () => {
  const slot = stripComments(read('src/components/dashboard/brief/BriefSlot.tsx'));
  const meta = slot.match(/export const SLOT_META[\s\S]*?\n};/);
  assert.ok(meta, 'BriefSlot no longer declares SLOT_META');

  const accents = [...meta[0].matchAll(/accent:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.equal(accents.length, 4, 'expected four slots to carry an accent');
  assert.deepEqual(
    accents.filter((a) => a !== 'text-text-secondary'),
    ['text-status-warning'],
    'exactly one slot may be tinted, and it is LANDMINE. Shipped, Decided and Open ' +
      'each already carry an icon AND a label; a third encoding of slot identity ' +
      'is decoration, and holding amber to landmines alone is what keeps it ' +
      'readable as a warning.',
  );
});

test('landmine tints resolve through the escalate tokens, so light mode keeps them', () => {
  // The card (BriefSlot) and the lines inside it (BriefLine) used two different
  // hard-coded ambers, neither with a light value.
  for (const file of [
    'src/components/dashboard/brief/BriefSlot.tsx',
    'src/components/dashboard/brief/BriefLine.tsx',
  ]) {
    assert.match(
      stripComments(read(file)),
      /bg-\[var\(--status-escalate-bg\)\]/,
      `${file} should tint landmines with --status-escalate-bg, which is defined in both themes`,
    );
  }
});

test('the portfolio count cards have an edge, not just a fill', () => {
  // `bg-surface` (#ffffff) on `--background` (#f7f9fc) is ~1.02:1 — a correct
  // token, an invisible card. Fill contrast alone is not a light-mode check.
  const portfolio = stripComments(read('src/pages/portfolio.tsx'));
  const card = portfolio.match(/function CountCard[\s\S]*?\n}/);
  assert.ok(card, 'portfolio no longer declares CountCard');
  assert.match(
    card[0],
    /border-border-subtle/,
    'a borderless count card disappears on the light surface, where card fill and ' +
      'page background are both effectively white',
  );
});

test('.dashboard-title is the inline page-header register, not a display title', () => {
  const css = stripComments(read('src/styles/globals.css'));
  const rule = css.match(/\.dashboard-title\s*\{[^}]*\}/);
  assert.ok(rule, 'globals.css no longer defines .dashboard-title');
  assert.doesNotMatch(
    rule[0],
    /clamp\(/,
    '.dashboard-title is back to a fluid display size. It is worn by every route ' +
      'in the app, inline beside each page\'s own controls; a 38-56px marketing ' +
      'title in that slot is the header system this replaced.',
  );
  const size = rule[0].match(/font-size:\s*(\d+)px/);
  assert.ok(size, '.dashboard-title should set an explicit px font-size');
  assert.ok(
    Number(size[1]) >= 16 && Number(size[1]) <= 20,
    `.dashboard-title is ${size[1]}px — the agreed page-header register is 16-20px`,
  );
});

test('every dashboard route names itself with .dashboard-title', () => {
  // Routes whose h1 is inline rather than supplied by <PageScaffold>. /projects'
  // header row lives in BriefWorkspace, its only renderer.
  const INLINE_TITLE_OWNERS = [
    'src/pages/index.tsx',
    'src/pages/board.tsx',
    'src/pages/portfolio.tsx',
    'src/pages/memory.tsx',
    'src/pages/setup.tsx',
    'src/pages/settings/usage.tsx',
    'src/components/dashboard/brief/BriefWorkspace.tsx',
  ];
  for (const file of INLINE_TITLE_OWNERS) {
    assert.match(
      stripComments(read(file)),
      /<h1 className="dashboard-title">/,
      `${file} should carry its route's <h1> on the shared .dashboard-title class`,
    );
  }

  // …and PageScaffold supplies the same class for everyone else.
  assert.match(
    stripComments(read('src/components/dashboard/PageScaffold.tsx')),
    /<h1 className="dashboard-title">\{title\}<\/h1>/,
    'PageScaffold should render its title as the shared .dashboard-title h1',
  );
});

test('no dashboard route re-rolls its own h1 type scale', () => {
  // The defect was three header systems, so the guard is that a page-level h1
  // cannot quietly become a fourth. Standalone flows outside the dashboard shell
  // (auth, checkout, onboarding, error pages) legitimately own their own type.
  const OUTSIDE_THE_SHELL = new Set([
    'src/pages/404.tsx',
    'src/pages/checkout.tsx',
    'src/pages/context/import.tsx',
    'src/pages/dev/blocking-banner.tsx',
    'src/pages/dev/brief-surfaces.tsx',
    'src/pages/invite.tsx',
    'src/pages/mcp-auth.tsx',
    'src/pages/oauth/consent.tsx',
    'src/pages/onboarding.tsx',
    'src/pages/select-plan.tsx',
    'src/components/AuthShell.tsx',
    'src/components/ErrorBoundary.tsx',
  ]);

  const walk = (dir, acc = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else if (/\.tsx$/.test(entry.name)) acc.push(full);
    }
    return acc;
  };

  const offenders = [];
  for (const full of walk(path.join(root, 'src'))) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (OUTSIDE_THE_SHELL.has(rel)) continue;
    for (const [, className] of stripComments(fs.readFileSync(full, 'utf8')).matchAll(/<h1\s+className="([^"]*)"/g)) {
      if (!className.includes('dashboard-title')) offenders.push(`${rel} → <h1 className="${className}">`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these h1s style themselves instead of wearing .dashboard-title, which is how ' +
      'the dashboard ended up with three page-header systems at once',
  );
});

// ── LAW 4: the theme-blind absolutes, as a ratchet ───────────────────────────

/**
 * `text-white`, `bg-black` and friends. Neither the palette rule nor the hex
 * rule above matches them — they are Tailwind's own utilities, not a raw hue
 * and not a hex — so both LAW 1 guards walked straight past seven of them.
 *
 * The dashboard is DARK-FIRST: `:root` is the dark palette (`--primary:
 * #10B981`) and light overrides it (`--primary: #047857`). White ink is
 * therefore correct in exactly one theme, and it is not the default one:
 *
 *   bg-primary + text-white   -> 2.54:1 in DARK  (#ffffff on #10B981)
 *   bg-primary + text-white   -> 5.48:1 in LIGHT (#ffffff on #047857)
 *   bg-primary + text-on-primary -> 7.56:1 dark, 5.48:1 light
 *
 * 2.56:1 fails WCAG AA for body text (4.5:1) and fails even the large-text bar
 * (3:1). `--on-primary` is the token that flips (#03120b dark / #ffffff light)
 * and `Button.tsx` had been using it correctly the whole time — the seven that
 * regressed were the hand-rolled buttons that never went through it, including
 * the prominent Copy control on /onboarding, which is the single most important
 * button on the activation path.
 *
 * This is the same defect marketing fixed in #400 and guarded with the same
 * ratchet; the dashboard had no equivalent, which is why it kept accruing here
 * for another three weeks. Two apps, one brand, one law.
 *
 * A BLANKET BAN WOULD BE WRONG. `text-white` on a genuinely always-dark surface
 * is correct. So this is a RATCHET: known debt is grandfathered per file and the
 * count may only fall. Lower a number when you convert one; never raise one. If
 * the surface really is always dark, add the FILE to ALWAYS_DARK with a reason
 * rather than raising its baseline.
 */
const THEME_BLIND = new RegExp(
  String.raw`\b(?:bg|text|border|ring|fill|stroke|divide|decoration)-(?:white|black)(?:/\d+)?\b`,
  'g',
);

/** Surfaces that are dark in every theme, so a theme-blind absolute is correct. */
const ALWAYS_DARK = new Map();

/**
 * Grandfathered debt. EMPTY as of 2026-09-01 (E-018), and it should stay that
 * way — a ratchet whose baseline is zero is just a law.
 *
 * Its one entry was `settings/skills.tsx`: the skill toggle's knob was
 * `bg-white` on a track that is `bg-primary` when on and `bg-overlay-strong`
 * when off, so in LIGHT mode it sat at 1.18:1 against an off-track compositing
 * to #ececee, and a switch whose thumb cannot be seen does not report its own
 * state.
 *
 * This comment used to say the fix needed "a new token pair, not a
 * substitution", and that was wrong — `--on-primary` and `--text-primary`
 * already existed, were already mapped in `@theme`, and already flip. What was
 * right is that no SINGLE value works: the two tracks sit at opposite ends of
 * the luminance range in each theme, so the ink has to flip with the switch's
 * STATE, not only with the theme. Measured:
 *
 *   on  + --on-primary    7.56:1 dark   5.48:1 light
 *   off + --text-primary  12.14:1 dark  14.65:1 light
 *
 * The lesson worth keeping is the one that made it debt for a day: "this needs
 * a design decision" was a guess, and four contrast ratios settled it. Do the
 * arithmetic before filing something as undecidable.
 *
 * If a genuinely always-dark surface ever appears, it goes in ALWAYS_DARK with
 * a written reason — never back into this map.
 */
const THEME_BLIND_BASELINE = new Map();

/** Every `.tsx` under src, so a new file is covered the day it lands. */
function allComponents() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx$/.test(entry.name)) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'src'));
  return out.sort();
}

test('theme-blind white/black classes never increase', () => {
  const grew = [];
  for (const file of allComponents()) {
    if (ALWAYS_DARK.has(file)) continue;
    const n = (stripComments(read(file)).match(THEME_BLIND) || []).length;
    const allowed = THEME_BLIND_BASELINE.get(file) || 0;
    if (n > allowed) grew.push(`${file}: ${n} (baseline ${allowed})`);
  }
  assert.deepEqual(
    grew,
    [],
    'text-white / bg-black exist in one theme only, and this app is dark-first. '
      + '--on-primary is the token for ink on a primary fill (#03120b dark, #ffffff light) '
      + 'and ui/Button.tsx already uses it. If the surface really is always dark, put the '
      + 'FILE in ALWAYS_DARK with a reason rather than raising this baseline.',
  );
});

test('no bg-primary fill carries theme-blind white ink', () => {
  // The specific pairing that produced all seven failures, pinned on its own so
  // the message names the fix. The ratchet above would also catch a reintroduction,
  // but only as "a number went up".
  const offenders = [];
  for (const file of allComponents()) {
    for (const [line] of stripComments(read(file)).matchAll(/^.*\bbg-primary(?:\/\d+)?\b.*$/gm)) {
      if (/\btext-white\b/.test(line)) offenders.push(`${file}: ${line.trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'bg-primary is #10B981 in dark mode; white ink on it is 2.54:1, below the 3:1 '
      + 'large-text floor and well below AA. Use text-on-primary.',
  );
});

test('--on-primary is a real token pair, not a single value', () => {
  // The ratchet is only worth having if the token it points people at actually
  // flips. If someone collapses --on-primary to one value, every converted call
  // site silently becomes the bug this law exists to stop.
  const css = read('src/styles/globals.css');
  assert.ok(
    css.includes('--on-primary: #03120b'),
    '--on-primary must keep its dark-theme value (#03120b) — near-black ink on emerald.',
  );
  assert.ok(
    css.includes('--on-primary: #ffffff'),
    '--on-primary must keep its light-theme value (#ffffff) — white ink on deep emerald.',
  );
  assert.ok(
    css.includes('--color-on-primary: var(--on-primary)'),
    '@theme must map --color-on-primary, or the `text-on-primary` utility does not exist '
      + 'and every converted call site renders with no colour at all.',
  );
});
