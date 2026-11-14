/**
 * Link colour ownership: a link's colour is decided by the utilities written on it.
 *
 * THE DEFECT THIS GUARDS. Round 3 added "Restore a project" (ArchivedProjectsNotice)
 * and "Update billing" (RefusalNotice) as filled buttons: `bg-primary
 * text-on-primary`. Both rendered in the PAGE's text colour on the green fill,
 * 3.15:1 in light and 2.28:1 in dark where 4.5:1 is needed. globals.css said
 * `a { color: inherit }` OUTSIDE any `@layer`, and Tailwind v4 puts
 * `.text-on-primary` inside `@layer utilities`. An unlayered rule beats every
 * layered rule whatever its specificity, so a bare `a` selector outranked the
 * class, and every link in the dashboard that asked for a colour by utility
 * (`text-primary`, `text-on-primary`, `text-[#03120b]`, …) got the colour of
 * whatever it sat in instead. Nothing in the source looked wrong.
 *
 * It is the fault tests/unlayered-display-contract.test.js guards for `display`,
 * one property over, and it is fixed the same way: the unlayered rule gives the
 * property up. Tailwind's preflight already says `a { color: inherit }` in
 * `@layer base`, so a link that asks for no colour still inherits one; a link
 * that asks for one now gets it.
 *
 * THE RULE — a rule in globals.css outside any `@layer` whose subject is a bare
 * element type must not set `color` on an element type that the dashboard also
 * colours with a utility. `<Link>` renders an `<a>`, so it counts as one.
 *
 * COMMENT-BLIND, like the display contract: the prose explaining the fix can
 * never fail the guard.
 *
 * Run: `node --test tests/unlayered-link-color-contract.test.js`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const GLOBALS = 'src/styles/globals.css';

/** The display contract's stripper: block comments blanked (line numbers kept), then `//` not after `:`. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every rule outside any @layer whose selector SUBJECT is a bare element type
 * (`a`, `a:hover`, `html.page-scroll body`, `input[type="radio"]`), with the
 * properties its body sets. A subject that carries a class (`.nav-link`,
 * `a.nav-link`) is a deliberate choice for that element and is not this guard's
 * business.
 */
function unlayeredTypeRules(css) {
  const rules = [];
  const stack = [];
  let buf = '';
  for (const ch of stripComments(css)) {
    if (ch === '{') {
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
      const props = new Set(
        frame.body.split(';').map((d) => d.split(':')[0].trim().toLowerCase()).filter(Boolean),
      );
      for (const selector of frame.prelude.split(',')) {
        const subject = selector.trim().split(/[\s>+~]+/).pop();
        const bare = subject.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '');
        const type = /^([a-z][a-z0-9-]*)(?=$|:)/.exec(bare);
        if (type) rules.push({ selector: selector.trim(), type: type[1], props });
      }
    } else {
      buf += ch;
    }
  }
  return rules;
}

/** The colour names a `text-*` utility can take: the theme's `--color-*` tokens plus Tailwind's palette. */
function themeColorNames(css) {
  return new Set([...stripComments(css).matchAll(/--color-([a-z][\w-]*)\s*:/g)].map((m) => m[1]));
}
const PALETTE = /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}$/;
const KEYWORD = /^(white|black|inherit|current|transparent)$/;

function isColorUtility(token, themeColors) {
  const utility = token.split(':').pop().replace(/^!|!$/g, '');
  if (!utility.startsWith('text-')) return false;
  const value = utility.slice(5).replace(/\/[\w.[\]%]+$/, '');
  if (value.startsWith('[')) return /^\[(#|var\(|rgb|hsl|oklch|color:)/.test(value);
  return themeColors.has(value) || PALETTE.test(value) || KEYWORD.test(value);
}

/**
 * Every `<a>` and `<Link>` in a file whose className carries a colour utility.
 * Reads the whole opening tag, across lines, and every string literal inside a
 * `className={...}` expression.
 */
/** The opening tag starting at `src[start] === '<'`: ends at the first `>` outside braces and quotes (`onClick={() => …}` included). */
function openingTag(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

function coloredLinks(rel, src, themeColors) {
  const out = [];
  const re = /<(a|Link)\b/g;
  let m;
  while ((m = re.exec(src))) {
    const tag = openingTag(src, m.index);
    const attr = /\bclassName\s*=\s*(?:"([^"]*)"|'([^']*)'|\{((?:[^{}]|\{[^{}]*\})*)\})/.exec(tag);
    if (!attr) continue;
    // An expression is read as words: quotes, braces and `${ ? :` separate them,
    // so a class inside a ternary inside a template still counts.
    const text = attr[1] ?? attr[2] ?? attr[3];
    const colors = text.split(/[\s'"`{}$?,()]+/).filter((t) => t && isColorUtility(t, themeColors));
    if (colors.length) {
      out.push({ where: `${rel}:${src.slice(0, m.index).split('\n').length}`, tag: m[1], colors });
    }
  }
  return out;
}

function sourceFiles() {
  const walk = (dir, acc = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else if (/\.(tsx|jsx)$/.test(entry.name) && !/\.test\.[tj]sx?$/.test(entry.name)) acc.push(full);
    }
    return acc;
  };
  return walk(path.join(root, 'src')).map((full) => ({
    rel: path.relative(root, full),
    src: stripComments(fs.readFileSync(full, 'utf8')),
  }));
}

function findLinkColorConflicts(files, css) {
  const themeColors = themeColorNames(css);
  const links = files.flatMap(({ rel, src }) => coloredLinks(rel, src, themeColors));
  const rules = unlayeredTypeRules(css).filter((r) => r.type === 'a' && r.props.has('color'));
  if (!links.length) return [];
  return rules.map((rule) =>
    `globals.css \`${rule.selector} { color: … }\` is unlayered, so it beats the colour utility on ` +
      `${links.length} link(s), e.g. ${links.slice(0, 3).map((l) => `${l.where} <${l.tag}> ${l.colors.join(' ')}`).join('; ')}`,
  );
}

test('the guard can see: it finds an unlayered colour on `a`, and the links it overrides', () => {
  const css = `
    @import "tailwindcss";
    @theme inline { --color-primary: var(--primary); --color-on-primary: var(--on-primary); }
    /* a { color: red; } */
    a { color: inherit; text-decoration: none; }
    button { font: inherit; }
    .nav-link { color: var(--text-muted); }
    @layer base { a:hover { color: red; } }
  `;
  const rules = unlayeredTypeRules(css);
  assert.deepEqual(rules.map((r) => r.type).sort(), ['a', 'button'], 'only bare-type subjects outside @layer count');
  assert.ok(rules.find((r) => r.type === 'a').props.has('color'));

  const themeColors = themeColorNames(css);
  assert.ok(isColorUtility('text-on-primary', themeColors));
  assert.ok(isColorUtility('hover:text-primary/90', themeColors));
  assert.ok(isColorUtility('text-[#03120b]', themeColors));
  assert.ok(isColorUtility('text-red-500', themeColors));
  assert.ok(!isColorUtility('text-[13px]', themeColors), 'a size is not a colour');
  assert.ok(!isColorUtility('text-sm', themeColors), 'a size is not a colour');

  const files = [
    { rel: 'fixture/Notice.tsx', src: '<Link\n  href="/x"\n  className="rounded-md bg-primary px-4 text-[13px] text-on-primary"\n>' },
    { rel: 'fixture/Plain.tsx', src: '<a href="/y" className="underline">' },
    { rel: 'fixture/Template.tsx', src: '<a className={`px-2 ${on ? "text-primary" : ""}`}>' },
    { rel: 'fixture/Arrow.tsx', src: '<Link onClick={() => go()} className="bg-primary text-[#03120b]">' },
  ];
  const links = files.flatMap(({ rel, src }) => coloredLinks(rel, src, themeColors));
  assert.deepEqual(links.map((l) => l.where), ['fixture/Notice.tsx:1', 'fixture/Template.tsx:1', 'fixture/Arrow.tsx:1']);
  assert.equal(findLinkColorConflicts(files, css).length, 1);
  assert.equal(findLinkColorConflicts(files, css.replace('a { color: inherit; ', 'a { ')).length, 0);
});

test('the links this was found on still ask for the on-primary colour, so the guard is not vacuous', () => {
  const themeColors = themeColorNames(read(GLOBALS));
  for (const rel of ['src/components/dashboard/RefusalNotice.tsx', 'src/components/dashboard/ArchivedProjectsNotice.tsx']) {
    const links = coloredLinks(rel, stripComments(read(rel)), themeColors);
    assert.ok(links.some((l) => l.colors.includes('text-on-primary')), `${rel}: no link with text-on-primary found`);
  }
});

test('no unlayered rule in globals.css sets `color` on `a` while a link asks for a colour by utility', () => {
  const offences = findLinkColorConflicts(sourceFiles(), read(GLOBALS));
  assert.deepEqual(
    offences,
    [],
    `An unlayered rule beats every Tailwind utility (they live in @layer utilities), so these ` +
      `links render in the colour of whatever they sit in:\n  ${offences.join('\n  ')}\n` +
      `Let the utilities own a link's colour: drop \`color\` from the unlayered rule (Tailwind's ` +
      `preflight already sets \`a { color: inherit }\` in @layer base).`,
  );
});
