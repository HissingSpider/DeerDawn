/**
 * Display ownership: an element's display is decided by ONE layer of the cascade.
 *
 * THE DEFECT THIS GUARDS. On a phone every signed-in page rendered the desktop
 * navigation. TopNav wrote `<nav className="dashboard-nav-links hidden md:flex">`
 * meaning "hidden below md", but `.dashboard-nav-links { display: flex }` in
 * globals.css is UNLAYERED, and Tailwind v4 puts `.hidden` and `.md:flex` inside
 * `@layer utilities`. An unlayered rule beats every layered rule whatever the
 * source order, media query or specificity, so `hidden` never applied. At 375px
 * the header held 742px of content with every ancestor `overflow-x: hidden`:
 * Trails, Connect, the plan badge, Settings and the account menu (which holds
 * sign-out AND the phone drawer) were off-screen and could not be scrolled to.
 * Nothing in the source looked wrong — `hidden md:flex` is the textbook idiom —
 * which is why it needs a mechanical check rather than review.
 *
 * RULE 1 — a class declared in globals.css outside any `@layer` that sets
 * `display` must never share an element with `hidden` or a variant display
 * utility (`md:flex`, `max-sm:hidden`, …). The custom class always wins, so the
 * utility is dead code that reads as working. "Share an element" includes a class
 * a component bakes into its root and a class its caller passes in.
 *
 * RULE 2 — a caller must not hand a bare `hidden` to a component whose root
 * already carries a bare display utility. Both then sit in `@layer utilities` at
 * equal specificity, and which wins is decided by Tailwind's internal sort, not
 * by anything written here. ThemeToggle bakes `inline-flex` into its root; TopNav
 * passed it `hidden sm:inline-flex`; Tailwind emits `.inline-flex` after
 * `.hidden`, so the toggle showed on phones for the same reason the nav did.
 * A variant (`max-sm:hidden`) is emitted after every base utility, so it is the
 * deterministic way to hide a component that owns its own display.
 *
 * COMMENT-BLIND. Both the stylesheet and the components explain, in prose, which
 * class combinations were removed and why. Every scan runs on comment-stripped
 * source so the documentation of a fix can never fail the guard.
 *
 * Run: `node --test tests/unlayered-display-contract.test.js`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/**
 * design-system-contract's stripper — block comments, then `//` not after `:` —
 * except that a block comment is blanked rather than deleted, so the line numbers
 * in a failure message are the file's real line numbers.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const DISPLAY_VALUES = new Set([
  'hidden', 'block', 'inline-block', 'inline', 'flex', 'inline-flex', 'grid',
  'inline-grid', 'contents', 'table', 'inline-table', 'table-row', 'table-cell',
  'flow-root', 'list-item',
]);

/** Split `md:hover:flex` into variants + utility, ignoring colons inside `[...]`. */
function splitVariants(token) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of token) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ':' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  // `!flex` (v3) and `flex!` (v4) are the same utility with !important.
  const utility = parts.pop().replace(/^!|!$/g, '');
  return { variants: parts, utility };
}

const isDisplayUtility = (token) => DISPLAY_VALUES.has(splitVariants(token).utility);
const isBareDisplay = (token) => isDisplayUtility(token) && splitVariants(token).variants.length === 0;
/** What RULE 1 forbids beside an unlayered display class. */
const isOverriddenDisplay = (token) => {
  const { variants, utility } = splitVariants(token);
  return DISPLAY_VALUES.has(utility) && (utility === 'hidden' || variants.length > 0);
};

/**
 * Classes that globals.css declares OUTSIDE any @layer with a `display`
 * declaration, mapped to the selector that declares it. Only the SUBJECT of a
 * selector counts: in `:root[data-theme="light"] .theme-light-only` it is
 * `.theme-light-only` that gets the display, not anything to its left.
 */
function unlayeredDisplayClasses(css) {
  const found = new Map();
  const stack = [];
  let buf = '';
  for (const ch of stripComments(css)) {
    if (ch === '{') {
      // `buf` holds any declarations of the enclosing block, then this prelude.
      const cut = buf.lastIndexOf(';');
      if (stack.length && cut >= 0) stack[stack.length - 1].body += buf.slice(0, cut + 1);
      const prelude = buf.slice(cut + 1).trim();
      const layered = /^@layer\b/.test(prelude) || stack.some((f) => f.layered);
      stack.push({ prelude, body: '', layered });
      buf = '';
    } else if (ch === '}') {
      const frame = stack.pop();
      if (!frame) continue;
      frame.body += buf;
      buf = '';
      if (frame.layered || frame.prelude.startsWith('@')) continue;
      if (!/(^|[;\s])display\s*:/.test(frame.body)) continue;
      for (const selector of frame.prelude.split(',')) {
        const subject = selector
          .replace(/\([^)]*\)/g, '')
          .trim()
          .split(/[\s>+~]+/)
          .pop();
        for (const m of subject.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
          if (!found.has(m[1])) found.set(m[1], selector.trim());
        }
      }
    } else {
      buf += ch;
    }
  }
  return found;
}

/**
 * Read a JS expression that starts at `src[start] === '{'` and collect the text
 * of every string literal and template chunk inside it. `level` is how many
 * `${...}` interpolations deep the text sits: level 0 is the static part of the
 * outermost template, which is what a component ALWAYS renders.
 */
function scanExpression(src, start) {
  const stack = ['{'];
  const strings = [];
  let cur = null;
  const interpolationDepth = () => stack.filter((s) => s === '${').length;
  let i = start + 1;
  for (; i < src.length && stack.length; i++) {
    const ch = src[i];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"' || top === '`') {
      if (ch === '\\') { cur.text += src[++i] || ''; continue; }
      if (ch === top) { stack.pop(); strings.push(cur); cur = null; continue; }
      if (top === '`' && ch === '$' && src[i + 1] === '{') {
        strings.push(cur);
        stack.push('${');
        cur = null;
        i++;
        continue;
      }
      cur.text += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      stack.push(ch);
      cur = { text: '', level: interpolationDepth() };
      continue;
    }
    if (ch === '{') { stack.push('{'); continue; }
    if (ch === '}') {
      const popped = stack.pop();
      if (popped === '${') cur = { text: '', level: interpolationDepth() };
      continue;
    }
  }
  return { end: i, strings };
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;
const tokensOf = (strings) => strings.flatMap((s) => s.text.split(/\s+/)).filter(Boolean);

/** Every `className=` in a file: its tokens, its level-0 tokens, where it is, what it says. */
function classNameAttributes(src) {
  const out = [];
  const re = /\bclassName\s*=\s*/g;
  let m;
  while ((m = re.exec(src))) {
    const at = m.index + m[0].length;
    const open = src[at];
    if (open === '"' || open === "'") {
      const close = src.indexOf(open, at + 1);
      if (close < 0) continue;
      const text = src.slice(at + 1, close);
      out.push({ index: m.index, text, tokens: tokensOf([{ text }]), staticTokens: tokensOf([{ text }]) });
    } else if (open === '{') {
      const { end, strings } = scanExpression(src, at);
      out.push({
        index: m.index,
        text: src.slice(at, end).replace(/\s+/g, ' '),
        tokens: tokensOf(strings),
        staticTokens: tokensOf(strings.filter((s) => s.level === 0)),
        passesClassNameProp: /\bclassName\b/.test(src.slice(at, end)),
      });
    }
  }
  return out;
}

/** The opening tag `<Name ...>` of every use of a capitalised component, with its className. */
function componentCallSites(src) {
  const out = [];
  const re = /<([A-Z][\w.]*)\b/g;
  let m;
  while ((m = re.exec(src))) {
    // Walk to the `>` that closes this opening tag, skipping `{...}` and strings.
    let i = m.index + m[0].length;
    let end = -1;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '{') { i = scanExpression(src, i).end; continue; }
      if (ch === '"' || ch === "'") {
        const close = src.indexOf(ch, i + 1);
        if (close < 0) break;
        i = close + 1;
        continue;
      }
      if (ch === '>') { end = i; break; }
      i++;
    }
    if (end < 0) continue;
    const tag = src.slice(m.index, end + 1);
    const attr = classNameAttributes(tag)[0];
    if (attr) out.push({ name: m[1], index: m.index, attr });
  }
  return out;
}

/**
 * For each component that forwards a `className` prop into a root className,
 * the classes that root always renders. Keyed by component name; a name defined
 * twice keeps both, and a call site is checked against each.
 */
function componentRoots(files) {
  const roots = new Map();
  for (const { rel, src } of files) {
    // Top-level declarations only, typed or not: `export function X(`,
    // `export const X: React.FC<P> = (`, `export const X = forwardRef(`.
    const decl = /(?:^|\n)(?:export\s+)?(?:default\s+)?(?:function\s+([A-Z]\w*)\s*\(|const\s+([A-Z]\w*)\b)/g;
    const starts = [];
    let m;
    while ((m = decl.exec(src))) starts.push({ name: m[1] || m[2], index: m.index });
    starts.forEach((s, n) => {
      const body = src.slice(s.index, n + 1 < starts.length ? starts[n + 1].index : src.length);
      const rootAttr = classNameAttributes(body).find((a) => a.passesClassNameProp);
      if (!rootAttr) return;
      const list = roots.get(s.name) || [];
      list.push({ rel, tokens: rootAttr.tokens, staticTokens: rootAttr.staticTokens });
      roots.set(s.name, list);
    });
  }
  return roots;
}

function sourceFiles() {
  const walk = (dir, acc = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else if (/\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\.[tj]sx?$/.test(entry.name)) acc.push(full);
    }
    return acc;
  };
  return walk(path.join(root, 'src')).map((full) => ({
    rel: path.relative(root, full),
    src: stripComments(fs.readFileSync(full, 'utf8')),
  }));
}

/** RULE 1 over a set of files and a stylesheet. Returns human-readable offences. */
function findUnlayeredDisplayConflicts(files, css) {
  const custom = unlayeredDisplayClasses(css);
  const roots = componentRoots(files);
  const offences = [];
  const check = (rel, src, index, tokens, text, via) => {
    const classes = [...new Set(tokens.filter((t) => custom.has(t)))];
    const utilities = [...new Set(tokens.filter(isOverriddenDisplay))];
    if (!classes.length || !utilities.length) return;
    for (const cls of classes) {
      offences.push(
        `${rel}:${lineOf(src, index)} — .${cls} (globals.css \`${custom.get(cls)}\` sets display, unlayered) ` +
          `is combined with ${utilities.join(' ')}${via}: ${text}`,
      );
    }
  };
  for (const { rel, src } of files) {
    for (const attr of classNameAttributes(src)) check(rel, src, attr.index, attr.tokens, attr.text, '');
    // Class strings held in constants, e.g. `const ROW = 'dashboard-nav-links hidden md:flex'`.
    for (const lit of src.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
      const tokens = lit[2].split(/\s+/).filter(Boolean);
      if (tokens.some((t) => custom.has(t)) && tokens.some(isOverriddenDisplay)) {
        const already = offences.some((o) => o.startsWith(`${rel}:${lineOf(src, lit.index)} `));
        if (!already) check(rel, src, lit.index, tokens, lit[0], ' in a class string');
      }
    }
    for (const site of componentCallSites(src)) {
      for (const rootDef of roots.get(site.name) || []) {
        check(
          rel, src, site.index, [...site.attr.tokens, ...rootDef.tokens], site.attr.text,
          ` via <${site.name}>, whose root in ${rootDef.rel} renders ${rootDef.tokens.filter((t) => custom.has(t) || isDisplayUtility(t)).join(' ')}`,
        );
      }
    }
  }
  return offences;
}

/** RULE 2: a bare `hidden` passed to a component whose root always renders a bare display utility. */
function findHiddenFightingComponentDisplay(files) {
  const roots = componentRoots(files);
  const offences = [];
  for (const { rel, src } of files) {
    for (const site of componentCallSites(src)) {
      if (!site.attr.tokens.includes('hidden')) continue;
      for (const rootDef of roots.get(site.name) || []) {
        const own = rootDef.staticTokens.filter((t) => isBareDisplay(t) && t !== 'hidden');
        if (!own.length) continue;
        offences.push(
          `${rel}:${lineOf(src, site.index)} — <${site.name} className=${site.attr.text}> passes a bare \`hidden\`, ` +
            `but ${rootDef.rel} always renders \`${own.join(' ')}\` on the same element. Both are in ` +
            `@layer utilities at equal specificity, so Tailwind's sort order decides, not this code. ` +
            `Use a variant (e.g. \`max-sm:hidden\`), which is emitted after every base utility.`,
        );
      }
    }
  }
  return offences;
}

const GLOBALS = 'src/styles/globals.css';

test('the guard can see: it finds an unlayered display class, and flags it beside a responsive utility', () => {
  // A guard whose parser silently finds nothing passes forever. Pin both halves
  // against a fixture so a parsing regression fails here, loudly.
  const css = `
    @import "tailwindcss";
    /* .commented-out { display: flex; } */
    .fixture-row { align-items: center; display: flex; }
    .fixture-plain { gap: 1rem; }
    :root[data-theme="light"] .fixture-subject { display: block; }
    @media (max-width: 720px) { .fixture-media { display: grid; } }
    @layer components { .fixture-layered { display: flex; } }
  `;
  const custom = unlayeredDisplayClasses(css);
  assert.deepEqual(
    [...custom.keys()].sort(),
    ['fixture-media', 'fixture-row', 'fixture-subject'],
    'unlayered display classes are: plain rules and rules inside @media, but not @layer and not a selector ancestor',
  );

  const files = [
    { rel: 'fixture/Bad.tsx', src: '<nav className="fixture-row hidden md:flex">' },
    { rel: 'fixture/Template.tsx', src: '<div className={`fixture-media ${open ? "max-sm:hidden" : ""}`}>' },
    { rel: 'fixture/Fine.tsx', src: '<nav className="fixture-plain hidden md:flex"><div className="fixture-layered hidden md:flex">' },
    { rel: 'fixture/Root.tsx', src: 'export function Panel({ className }) { return <div className={`fixture-row ${className}`} />; }' },
    { rel: 'fixture/Caller.tsx', src: '<Panel className="hidden lg:flex" />' },
  ];
  const offences = findUnlayeredDisplayConflicts(files, css);
  assert.equal(offences.length, 3, offences.join('\n'));
  assert.match(offences.join('\n'), /fixture\/Bad\.tsx:1 — \.fixture-row/);
  assert.match(offences.join('\n'), /fixture\/Template\.tsx:1 — \.fixture-media/);
  assert.match(offences.join('\n'), /fixture\/Caller\.tsx:1 — \.fixture-row .* via <Panel>/);

  const rule2 = findHiddenFightingComponentDisplay([
    { rel: 'fixture/Toggle.tsx', src: 'export function Toggle({ className = "" }) { return <div className={`inline-flex gap-1 ${className}`} />; }' },
    { rel: 'fixture/UsesToggle.tsx', src: '<Toggle className="hidden sm:inline-flex" /><Toggle className="max-sm:hidden" />' },
  ]);
  assert.equal(rule2.length, 1, rule2.join('\n'));
  assert.match(rule2[0], /fixture\/UsesToggle\.tsx:1 — <Toggle/);
});

test('globals.css still declares the unlayered display classes this guard is about', () => {
  // If the stylesheet ever moves into @layer components wholesale this set
  // empties and RULE 1 becomes vacuous — which is fine, but it should be a
  // decision someone sees, not a guard that quietly stopped guarding.
  const custom = unlayeredDisplayClasses(read(GLOBALS));
  assert.ok(custom.has('dashboard-topnav'), 'expected .dashboard-topnav to be an unlayered display class');
  assert.ok(custom.size >= 5, `only ${custom.size} unlayered display classes found — has the parser broken?`);
});

test('no unlayered display class from globals.css shares an element with `hidden` or a variant display utility', () => {
  const offences = findUnlayeredDisplayConflicts(sourceFiles(), read(GLOBALS));
  assert.deepEqual(
    offences,
    [],
    `An unlayered rule in globals.css beats every Tailwind utility (they live in ` +
      `@layer utilities), so the display utility on these elements never applies:\n  ` +
      offences.join('\n  ') +
      `\nLet the utilities own display on that element: remove \`display\` from the ` +
      `custom class (and give any other users of the class an explicit display utility).`,
  );
});

test('no caller hides a component with a bare `hidden` that the component\'s own display utility can beat', () => {
  const offences = findHiddenFightingComponentDisplay(sourceFiles());
  assert.deepEqual(offences, [], offences.join('\n'));
});
