'use strict';

// The layouts a person's own instruction file can be in when DeerDawn's block
// (between an opening and a closing marker) is refreshed or taken out, as a
// round-2 walker found them. Shared by the boot tests and project-sync tests
// (packages/mcp-server) and the apply_setup tests (here), so every path is held
// to the same expectations.
//
// Each layout is built from the person's text around an OLD block, and says
// exactly what the file must be afterwards, written out by hand rather than
// computed by the code under test:
//   pair    a well-formed pair exists: the first one's span, from its opening
//           marker to its closing marker, becomes NEW; every other byte stays.
//           `removed` is the file with that pair taken out: its marker lines and
//           everything between them go, and when they opened the file, so does
//           the blank line DeerDawn put after them.
//   append  no well-formed pair: the person's text stays byte for byte, NEW is
//           added after it (or, for a sync that puts its block first, before
//           it), and every stray marker stays where it was. Nothing is removed.

const OPEN = '<!-- deerdawn:auto-context -->';
const CLOSE = '<!-- /deerdawn:auto-context -->';

const OLD_INNER = '## DeerDawn\nAn older copy of these instructions.\n';
const OLD = `${OPEN}\n${OLD_INNER}${CLOSE}`;

const P1 = '# My global notes\n\nI write TypeScript at work — naïve café style.\n- Use pnpm, never npm.\n- Run `make test` before every commit.\n';
const P2 = '## Code review\n\nNever approve my own PRs.\n  Indented line with trailing spaces   \n\tTabbed line\n';
const P3 = '## Last section\nKeep answers short.\n';
const BIG = Array.from({ length: 2600 }, (_, i) => `- rule ${i}: keep line ${i} exactly as written, ${'x'.repeat(40)}`).join('\n') + '\n';

const crlf = (text) => text.replace(/\r?\n/g, '\r\n');

/**
 * NEW is the block the refresh writes, starting with the opening marker and
 * ending with the closing one, no trailing newline. `open`/`close` default to
 * the global instruction block's markers; `prepend` is for a writer that puts a
 * new block above the person's text (project sync) rather than below it.
 */
function buildLayouts(NEW, { open = OPEN, close = CLOSE, prepend = false, strict = false } = {}) {
  const old = `${open}\n${OLD_INNER}${close}`;
  const pair = (name, before, after, removed, oldBlock = old) => ({ name, kind: 'pair', seeded: before + oldBlock + after, expected: before + NEW + after, removed });
  // Every append layout below ends with a newline, so one blank line separates
  // the person's text from the block, whichever side it goes.
  const append = (name, seeded) => ({ name, kind: 'append', seeded, expected: prepend ? `${NEW}\n\n${seeded}` : `${seeded}\n${NEW}\n`, removed: seeded });
  return [
    pair('block at top', '', `\n\n${P1}`, P1),
    pair('block in the middle', `${P1}\n`, `\n\n${P2}`, `${P1}\n\n${P2}`),
    pair('block at the end', `${P1.trimEnd()}\n\n`, '\n', `${P1.trimEnd()}\n\n`),
    pair('only the block', '', '\n', ''),
    // The first pair is refreshed (or taken out) and the second is left exactly as it was.
    pair('two blocks', `${P1}\n`, `\n\n${P2}\n${old}\n\n${P3}`, `${P1}\n\n${P2}\n${old}\n\n${P3}`),
    // Structural: whatever sits between a well-formed pair is DeerDawn's.
    pair('the person\'s edits inside the markers', `${P1}\n`, `\n\n${P2}`, `${P1}\n\n${P2}`, `${open}\nMY OWN NOTE: never push to main on Fridays.\n${OLD_INNER}${close}`),
    append('only the opening marker', `${P1}\n${open}\n${OLD_INNER}${P2}`),
    append('only the closing marker', `${P1}\n${OLD_INNER}${close}\n\n${P2}`),
    append('closing marker before opening marker', `${P1}${close}\n${P2}\n${open}\n${P3}`),
    // Story A: a note that QUOTES the opening marker, above a section, with the
    // real block further down. Only the real block is DeerDawn's.
    pair('marker quoted in prose', `${P1}DeerDawn keeps its block between \`${open}\` and its closing marker; leave it alone.\n\n${P2}\n`, '\n', `${P1}DeerDawn keeps its block between \`${open}\` and its closing marker; leave it alone.\n\n${P2}\n`),
    append('both markers quoted in prose, no block', `${P1}See \`${open}\` ... \`${close}\` in the docs.\n\n${P2}`),
    append('markers sharing their lines with other text', `${P1}${open} keep this line\n${OLD_INNER}and this one ${close}\n${P2}`),
    // A fenced example of the markers is an example, not a block.
    pair('marker in a code fence', `${P1}\n\`\`\`md\n${open}\nan example\n${close}\n\`\`\`\n\n${P2}\n`, '\n', `${P1}\n\`\`\`md\n${open}\nan example\n${close}\n\`\`\`\n\n${P2}\n`),
    append('only a fenced example, no block', `${P1}\n~~~\n${open}\n${close}\n~~~\n${P2}`),
    // How this repository's own docs talk about DeerDawn's markers: in a
    // sentence, in inline code, and in a fenced example. None of it is a block.
    append('docs describing the markers in prose and in a fence', `# Agents\n\nDeerDawn writes its block between \`${open}\` and \`${close}\`,\nalways at the top of the file:\n\n\`\`\`markdown\n${open}\n## DeerDawn Context\n${close}\n\`\`\`\n\nNever edit inside those markers by hand.\n`),
    { name: 'CRLF line endings', kind: 'pair', seeded: crlf(`${P1}\n${old}\n\n${P2}`), expected: crlf(`${P1}\n${NEW}\n\n${P2}`), removed: crlf(`${P1}\n\n${P2}`) },
    // The file still ends where it ended: no newline is added after the block.
    pair('no trailing newline', `${P1.trimEnd()}\n\n`, '', `${P1.trimEnd()}\n\n`),
    // Nothing to replace and no final newline: a line break goes between the
    // person's text and the block so the block has lines of its own.
    { name: 'no trailing newline and no block', kind: 'append', seeded: P1.trimEnd(), expected: prepend ? `${NEW}\n\n${P1.trimEnd()}` : `${P1.trimEnd()}\n\n${NEW}\n`, removed: P1.trimEnd() },
    pair('200 KB of the person\'s text', `${BIG}\n`, `\n\n${P2}`, `${BIG}\n\n${P2}`),
    // Surrounding whitespace (and a byte-order mark) still leaves a marker the
    // whole of its line. A refresh leaves that whitespace where it was; taking
    // the block out takes its lines, and keeps the byte-order mark.
    ...(strict
      ? [
        // DeerDawn's own block (global files) starts at column 0: a byte-order mark
        // and spaces after the closing marker are fine, indentation is not.
        { name: 'byte-order mark and trailing spaces', kind: 'pair', seeded: `\ufeff${open}\n${OLD_INNER}${close}  \n\n${P2}`, expected: `\ufeff${NEW}  \n\n${P2}`, removed: `\ufeff${P2}` },
        append('indented markers (a code block, a list, a quote: not the block)', `${P1}\n\n    ${open}\n    ${OLD_INNER}    ${close}\n\n${P2}`),
      ]
      : [
        { name: 'byte-order mark and indented markers', kind: 'pair', seeded: `\ufeff  ${open}\n${OLD_INNER}\t${close}  \n\n${P2}`, expected: `\ufeff  ${NEW}  \n\n${P2}`, removed: `\ufeff${P2}` },
      ]),
  ];
}

/** The two that are about the file, not its text: DeerDawn cannot or must not write them. */
function buildUnwritableLayouts({ open = OPEN, close = CLOSE } = {}) {
  const seeded = `${P1}\n${open}\n${OLD_INNER}${close}\n\n${P2}`;
  return [
    { name: 'read-only file', kind: 'readonly', seeded },
    { name: 'symlink', kind: 'symlink', seeded },
  ];
}

module.exports = { OPEN, CLOSE, OLD, P1, P2, P3, buildLayouts, buildUnwritableLayouts, crlf };
