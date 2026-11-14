/**
 * Task card bodies on the board — the structural half of the contract.
 *
 * The behavioural half lives in `src/lib/taskCardBody.test.ts`, which runs the
 * clip, the save plan and the write-target resolution against real inputs. This
 * file covers only what that one structurally cannot: WHERE a body is allowed to
 * be rendered, and that the board still routes its decisions through those
 * functions instead of re-deciding inline.
 *
 * The rule being pinned: a body is opened, never scanned. Six narrow columns of
 * titles are the whole point of the board, and 2,000 characters of spec on one
 * card buries the twenty around it. shared-context reached the same conclusion
 * for the MCP surfaces the hard way — a listing that inlined bodies blew the
 * response budget silently, so a listing now prints a ` +body` marker and
 * `formatTaskCardDetail` is the only renderer that prints one.
 *
 * Run: `node --test tests/task-card-body-contract.test.js`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const BOARD = 'src/components/dashboard/brief/TaskBoard.tsx';
const DIALOG = 'src/components/dashboard/brief/TaskCardBody.tsx';
const LIB = 'src/lib/taskCardBody.ts';
const BRIEF_DIR = 'src/components/dashboard/brief';

/** Source with block and line comments stripped — comments are not behaviour. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const board = read(BOARD);
const dialog = read(DIALOG);
const lib = read(LIB);
const boardCode = code(board);
const dialogCode = code(dialog);

const countOf = (source, pattern) => (source.match(pattern) || []).length;

/** A `{something.body}` interpolation — a body being printed into the tree. */
const RENDERS_A_BODY = /\{\s*[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)*\.body\s*\}/g;

// ── A body is opened, not scanned ────────────────────────────────────────────

test('the dialog is the only file under brief/ that renders a card body', () => {
  const offenders = fs
    .readdirSync(path.join(root, BRIEF_DIR))
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\./.test(name))
    .map((name) => [`${BRIEF_DIR}/${name}`, code(read(`${BRIEF_DIR}/${name}`))])
    .filter(([rel, source]) => rel !== DIALOG && RENDERS_A_BODY.test(source));

  assert.deepEqual(
    offenders.map(([rel]) => rel),
    [],
    'a card body is being printed outside the dialog — mark that the card has one and let it be opened',
  );
});

test('the board marks a body and never prints one', () => {
  assert.equal(
    countOf(boardCode, RENDERS_A_BODY),
    0,
    'TaskBoard renders a body into a column card',
  );
  assert.match(boardCode, /<TaskCardBodyMarker\b/, 'the board no longer marks which cards have a body');
  assert.match(boardCode, /hasBody=\{Boolean\(card\.body\)\}/, 'the marker is not driven by the card body');
  assert.equal(
    countOf(boardCode, /whitespace-pre-/g),
    0,
    'TaskBoard lays out multi-line body text — that belongs in the dialog',
  );
});

test('the dialog preserves the line breaks in a body', () => {
  // A body is prose, a checklist or a short spec; collapsed to one line it stops
  // being readable. shared-context splits a body on newlines before neutralizing
  // each line for exactly this reason.
  assert.match(dialogCode, /whitespace-pre-wrap/, 'the dialog collapses a body onto one line');
});

// ── The write path ───────────────────────────────────────────────────────────

test('a body is written by re-adding the card title', () => {
  // `add_todos:[{title, body}]` sets the body of the card that title names and
  // leaves its id, title and column alone. It is the only write path a body has:
  // PATCH /projects/:id/context has no todo_items field.
  assert.match(
    boardCode,
    /add_todos:\s*\[\{\s*title:\s*card\.title,\s*body\s*\}\]/,
    'the body save no longer sends a title+body add',
  );
  assert.match(
    boardCode,
    /body\?:\s*string/,
    'the Directive type dropped body, so the save is being cast past the contract',
  );
});

test('the board asks which card a save would hit before offering to write', () => {
  // Refusing a duplicate/unmatched title in the UI is the whole guard: the merge
  // matches on title alone, so the write itself cannot tell it went wrong.
  assert.match(boardCode, /resolveBodyTarget\(effective\?\.todo_items,/, 'the target is no longer resolved, or is resolved against the rendered column instead of the stored cards');
});

test('the dialog routes its decisions through the lib, not inline', () => {
  for (const fn of ['planBodySave', 'bodyLengthNote', 'taskBodyIsAtLimit']) {
    assert.match(dialogCode, new RegExp(`\\b${fn}\\(`), `the dialog stopped using ${fn}`);
  }
  assert.match(boardCode, /bodySavedNotice\(clipped\)/, 'the save toast no longer reports clipping');
});

// ── Clipping is never implied away ───────────────────────────────────────────

test('the editor warns about the clip instead of silently swallowing keystrokes', () => {
  // maxLength would enforce the cap by dropping characters as they are typed,
  // with no explanation — the same lie in the other direction. The server clips
  // and never rejects, so the honest UI accepts the text and says what will be
  // stored.
  assert.equal(
    countOf(dialogCode, /maxLength/g),
    0,
    'the body textarea caps input with maxLength — say where the cut lands instead',
  );
  assert.match(dialogCode, /counter\.text/, 'the live length counter is gone');
  assert.match(dialogCode, /BODY_AT_LIMIT_NOTE/, 'a body that arrived clipped is no longer flagged when read');
});

test('the optimistic board shows the stored body, not the typed one', () => {
  // The save posts the CLIPPED text and the local override is built from that
  // same value; showing the typed text back would claim a save that did not
  // happen, until the refetch quietly replaced it.
  assert.match(
    boardCode,
    /\{\s*\.\.\.t,\s*body,\s*updated_at:\s*now\s*\}/,
    'the optimistic card is built from something other than the body being sent',
  );
  assert.match(dialogCode, /setDraft\(plan\.body\)/, 'the editor keeps the typed text after a clipped save');
});

// ── House rules ──────────────────────────────────────────────────────────────

test('the body surfaces add no gradient, no emoji and no raw colour', () => {
  // Comment-blind: a PR number reads as a hex colour, and pinning the reason a
  // rule exists must not be what trips it.
  for (const [name, source] of [[DIALOG, dialogCode], [LIB, code(lib)]]) {
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
  }
  for (const [name, source] of [[DIALOG, dialog], [LIB, lib]]) {
    assert.equal(countOf(source, /\p{Extended_Pictographic}/gu), 0, `${name} contains an emoji`);
  }
});
